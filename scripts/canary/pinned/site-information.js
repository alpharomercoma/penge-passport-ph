var SITE_REGION_ID = "#SiteRegionID";
var SITE_COUNTRY_ID = "#SiteCountryID";
var SITE_ID = "#SiteID";

function loadRegions(regionId, option)
{
    StartLoad();
    $.post(GetCountriesUrl, { regionId: regionId }).done(
        function (data) {
            var countries = [];
            $.each(data.Countries, function (Id, Value) {
                var siteInfo = (option == "R") && (regionId != "1") ? new SiteInformation(Value.Address, Value.Telephone, Value.Description, Value.Timeslot, Value.Url) : null;
                var country = new Country(Value.Id, Value.Name, siteInfo);
                countries.push(country);
            });
            region = new Region(regionId, countries);
            Regions.push(new Region(regionId, countries));
        })
    .always(function (data) {
        EndLoad();
        countryChanged($(SITE_COUNTRY_ID)[0]);
    });

    var siteId = $('#SiteID').val();
    if (siteId == null) {
        $(':button[name="submitcommand"]').prop('disabled', true);
    }
}

function displaySite(control) {
    var regionId = $(SITE_REGION_ID).val();
    var countryId = $(SITE_COUNTRY_ID).val();
    var region = filterById(regionId, Regions);
    var country = filterById(countryId, region.countries);
    var site = filterById(control.value, country.sites);
    if (!site.siteInformation) {
        StartLoad();
        $.post(SiteDisplayUrl, { id: control.value }).done(
        function (data) {
            var siteInformation = new SiteInformation(data.Address, data.Telephone, data.Description, data.Timeslot, data.Url);
            site.siteInformation = siteInformation;
            displaySiteInformation(site.siteInformation);
        })
        .always(function (data) {
            EndLoad();
        });

    }
    else {
        displaySiteInformation(site.siteInformation);
    }
}

function displaySiteInformation(siteInformation)
{
    $('#address').html(siteInformation.address);
    $('#telephone').html(siteInformation.telephone);
    $('#description').html(siteInformation.description);
    $('#timeslots').html(siteInformation.timeslot);
    $('#GoogleMapLink').attr('href', siteInformation.url);
    if (siteInformation.url && siteInformation.url !== "")
        $('#GoogleMapLink').removeClass('hidden');
    else
        $('#GoogleMapLink').addClass('hidden');
}

function resetFields() {
    displaySiteInformation(new SiteInformation("-", "-", "-", "-", ""));
}

function regionChanged(control) {
    var value = control.value;
    resetFields();
    if(value === "")
    {
        resetDropDown(SITE_COUNTRY_ID);
        resetDropDown(SITE_ID);
    }
    else
    {
        resetDropDown(SITE_COUNTRY_ID);
        resetDropDown(SITE_ID);
        var region = filterById(value, Regions);
        if (!region) {
            StartLoad();
            $.post(GetCountriesUrl, { regionId: value }).done(
                function (data) {
                    var countries = [];
                    $.each(data.Countries, function (Id, Value) {
                        var siteInfo = new SiteInformation(Value.Address, Value.Telephone, Value.Description, Value.Timeslot, Value.Url);
                        var country = new Country(Value.Id, Value.Name, siteInfo);
                        countries.push(country);
                    });
                    region = new Region(value, countries);
                    Regions.push(new Region(value, countries));
                    populateCountries(region.countries);
                })
            .always(function (data) {
                EndLoad();
            });
        }
        else
        {
            populateCountries(region.countries);
        }
    }
}

function populateCountries(countries)
{
    populateDropdown(SITE_COUNTRY_ID, countries);
}

function populateSites(sites)
{
    populateDropdown(SITE_ID, sites);
}

function resetDropDown(controlId) {
    $(':button[name="submitcommand"]').prop('disabled', true);
    $(controlId).val("");
    $(controlId + " option[value!=\"\"]").remove();
}

function populateDropdown(controlId, list) {
    $.each(list,
        function (id, value) {
            $(controlId).append($('<option>', { value: value.id }).text(value.name));
        });
}

function countryChanged(control) {
    var value = control.value;
    resetFields();
    if (value === "")
    {
        resetDropDown(SITE_ID);
    }
    else
    {
        resetDropDown(SITE_ID);
        var regionId = $(SITE_REGION_ID).val();
        var region = filterById(regionId, Regions);
        var country = filterById(value, region.countries);
        var siteId = $('#currentSiteId').val();  
        if ((regionId == 1 && !country.sites) || (regionId != 1 && (country.sites && !country.sites.timeslot)) || (!country.sites || (country.sites && !country.sites.address))) {
            StartLoad();
            $.post(GetSitesUrl, { regionId: regionId, countryId: value, siteId: siteId }).done(
                function (data) {
                    var sites = [];
                    $.each(data.Sites, function (Id, Value) {
                        var siteInfo = new SiteInformation(Value.Address, Value.Telephone, Value.Description, Value.Timeslot, Value.Url);
                        var site = new Site(Value.Id, Value.Name, siteInfo);
                        sites.push(site);
                    });
                    country.sites = sites;
                    populateSites(country.sites);
                })
            .always(function (data) {
                EndLoad();
            });
        }
        else {
            populateSites(country.sites);
        }
    }
}