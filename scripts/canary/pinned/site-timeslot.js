var timeSlotText = "Timeslots will be available soon.";

function getTimeSlots(requiredSlots, displayContainer) {
    Promise.resolve(1)
    .then(StartLoad)
    .then(resetTimeSlotInfo)
    .then(function () {
        var token = $("input[name='__RequestVerificationToken']").val();
        $.ajaxSetup({
            headers:{
                '__RequestVerificationToken': token
            }
        });
        return $.post(GetAvailableTimeSlotUrl, {
            preferredDate: $('#datepicker-input').val(),
            siteId: $("#SiteID").val(),
            requiredSlots: requiredSlots
        }).done(function (data) {
            if ($.trim(data) === "") {
                $(displayContainer).html(timeSlotText);
            }
            else {
                $(displayContainer).html(data);
            }
        });
    })
    .catch(function (e) {
        console.error(e);
    })
    .then(disableNextButton)
        .then(EndLoad);
}

function getAvailableDates(slots, siteId)
{
    var possibleDate = moment(currentDate)._d;
    possibleDate.setDate(possibleDate.getDate() + NON_ALLOWABLE_DAYS);
    var requestDate = formattedDate(possibleDate);
    var maxDate = formattedDate(MAX_DATE);
    Promise.resolve(1)
    .then(StartLoad)
    .then(getTimeslotAvailability(requestDate, maxDate, slots, siteId))
    .then(initDatePicker(requestDate, maxDate, slots))
    .catch(function (e) {
        console.log(e);
    })
    .then(EndLoad);
}

function siteChanged(slots, displayContainer) {
    var siteId = $(displayContainer).val();
    getAvailableDates(slots, $("#SiteID").val());
    resetTimeSlotInfo();
    disableNextButton();
}

function showSpecialNote(radioButton){
    var note = radioButton.nextElementSibling.innerHTML;
    if(note !== "")
    {
        $(".timeslot-info span").html(note);
        $(".timeslot-info").removeClass("hidden");
    }
    else
    {
        resetTimeSlotInfo();
    }
}

function resetTimeSlotInfo()
{
    $(".timeslot-info span").html("");
}
function RemoveDisabledButton() {   
    document.getElementById("NextButton").removeAttribute("disabled");
    document.getElementById("calendarCaptcha").style.display = 'block';
}

function disableNextButton() {
    document.getElementById("NextButton").disabled = true;
    document.getElementById("calendarCaptcha").style.display = 'none';
}

var formattedDate__ = null;
function initDatePicker(startDate, endDate, slots)
{
    return function () {
        if (formattedDate__ !== null)
            $("#datepicker").datepicker("remove");
        $("#datepicker").datepicker({
            format: 'yyyy-mm-dd',
            startDate: startDate,
            endDate: endDate,
            beforeShowDay: getBeforeShow('day', false),
            beforeShowMonth: getBeforeShow('month')
        });
        $('#datepicker').off("changeDate");
        $('#datepicker').on(
            "changeDate",
            function () {
                $('#datepicker-input').val(
                    $('#datepicker').datepicker('getFormattedDate')
                );
                getTimeSlots(slots, "#schedule-container");
            }
        );
        formattedDate__ = $('#datepicker').datepicker('getFormattedDate');
    }
}

function getTimeslotAvailability(requestDate, maxDate, slots, siteId)
{
    return function () {
        var token = $("input[name='__RequestVerificationToken']").val();
        $.ajaxSetup({
            headers:{
                '__RequestVerificationToken': token
            }
        });

        return $.post(GetTimeslotAvailabilityUrl, {
            fromDate: requestDate, toDate: maxDate, siteId: siteId, requestedSlots: slots
        }).then(function (data) {
            var possibleDate;

            maxPossibleDate = new Date(possibleDate);
            maxPossibleDate.setDate(maxPossibleDate.getDate() - 1);
            $("#schedule-container").html(timeSlotText);
            $("#next-available-date").html('No available date');
            document.getElementById("earliest-available").className = "text-danger";

            if (data.length > 0) {
                var first = data.find(function (i) {
                    return i.IsAvailable;
                });

                if (first != null && first.AppointmentDate != null) {
                    var date = moment(first.AppointmentDate).utc();
                    possibleDate = date.minutes(date.minutes() - date.utcOffset());
                     $("#next-available-date").html(possibleDate.format('DD MMMM YYYY'));
                    document.getElementById("earliest-available").className = "text-success";                    
                }

                var __e = $(document.createElement('p'));
                __e.addClass("text-info bg-info");
                __e.html("Please Select a Date");
                $("#schedule-container").html(__e);
            } 

            dates = data.map(function (d) {
                var date = moment(d.AppointmentDate).utc();
                return {
                    IsAvailable: d.IsAvailable,
                    AppointmentDate: date.minutes(date.minutes() - date.utcOffset())
                }
            });
        });
    }
}

var dates;

function getBeforeShow(dateUnit, noHitReturn)
{
    return function(date) {
        var momentDate = moment(date.setMinutes(date.getMinutes() - date.getTimezoneOffset()));
        var result = $.grep(dates, function(elem, index){
            return momentDate.isSame(elem.AppointmentDate.local(), dateUnit);
        });
        var classes = '';
        if (result.length === 0)
            return noHitReturn;
        var isAvailableResult = $.grep(result, function(elem, index){
            return elem.IsAvailable;
        });
        if (isAvailableResult.length > 0)
            classes = 'available';
        else
            classes = 'not-available';
        return { classes : classes };
    }
}

function formattedDate(_date)
{
    return moment(_date).format('YYYY-MM-DD');
}

